#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="${TF_DIR:-$ROOT_DIR}"
TFVARS_FILE="${TFVARS_FILE:-$TF_DIR/terraform.tfvars}"
ALLOWED_UPDATES='["message","my_chat_member","callback_query"]'

die() {
  echo "error: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

read_tfvars_string() {
  local key="$1"
  local file="$2"
  awk -F= -v wanted="$key" '
    $0 ~ "^[[:space:]]*" wanted "[[:space:]]*=" {
      value = substr($0, index($0, "=") + 1)
      sub(/^[[:space:]]*/, "", value)
      sub(/[[:space:]]*(#.*)?$/, "", value)
      if (value ~ /^"/) {
        sub(/^"/, "", value)
        sub(/"$/, "", value)
      }
      print value
      exit
    }
  ' "$file"
}

require_cmd terraform
require_cmd curl
require_cmd python3

[[ -f "$TFVARS_FILE" ]] || die "terraform tfvars file not found: $TFVARS_FILE"

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-$(read_tfvars_string "telegram_bot_token" "$TFVARS_FILE")}"
AWS_REGION="${AWS_REGION:-$(read_tfvars_string "aws_region" "$TFVARS_FILE")}"
AWS_PROFILE="${AWS_PROFILE:-$(read_tfvars_string "aws_profile" "$TFVARS_FILE")}"

[[ -n "${BOT_TOKEN:-}" ]] || die "telegram_bot_token is missing in $TFVARS_FILE"
AWS_REGION="${AWS_REGION:-eu-central-1}"

TF_OUTPUT_ARGS=(-chdir="$TF_DIR")
if [[ -n "${AWS_PROFILE:-}" ]]; then
  export AWS_PROFILE
fi
if [[ -n "${AWS_REGION:-}" ]]; then
  export AWS_REGION
fi

URL="$(terraform "${TF_OUTPUT_ARGS[@]}" output -raw function_url)"
SECRET="$(terraform "${TF_OUTPUT_ARGS[@]}" output -raw telegram_secret_token)"

[[ -n "$URL" ]] || die "terraform output function_url was empty"
[[ -n "$SECRET" ]] || die "terraform output telegram_secret_token was empty"

echo "Registering Telegram webhook..."
echo "  terraform dir: $TF_DIR"
echo "  aws profile: ${AWS_PROFILE:-<default>}"
echo "  aws region: $AWS_REGION"
echo "  webhook url: $URL"

REGISTER_RESPONSE="$(curl -sS "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${URL}" \
  --data-urlencode "secret_token=${SECRET}" \
  --data-urlencode "allowed_updates=${ALLOWED_UPDATES}")"

REGISTER_OK="$(printf '%s' "$REGISTER_RESPONSE" | python3 -c 'import json,sys; print("true" if json.load(sys.stdin).get("ok") else "false")')"
if [[ "$REGISTER_OK" != "true" ]]; then
  echo "$REGISTER_RESPONSE"
  die "Telegram rejected setWebhook"
fi

INFO_RESPONSE="$(curl -sS "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo")"

echo
echo "Webhook registered."
printf '%s' "$REGISTER_RESPONSE" | python3 -c '
import json, sys
data = json.load(sys.stdin)
print("  setWebhook:", data.get("description", "ok"))
'
printf '%s' "$INFO_RESPONSE" | python3 -c '
import json, sys
data = json.load(sys.stdin)
result = data.get("result") or {}
print("  current url:", result.get("url", ""))
print("  pending updates:", result.get("pending_update_count", 0))
print("  last error date:", result.get("last_error_date", "-"))
print("  last error message:", result.get("last_error_message", "-"))
'
