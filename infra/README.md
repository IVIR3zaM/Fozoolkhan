# Infrastructure (Terraform)

Deploys فضول‌خان to AWS **Frankfurt (eu-central-1)** with the `personal` profile:

- **DynamoDB** single table (on-demand, TTL on `ttl`)
- **Lambda** (Node 20, arm64) with a public **Function URL** (no API Gateway)
- **IAM** least-privilege role (DynamoDB + Bedrock invoke + its log group)
- **CloudWatch Logs** group with short retention
- Optional **AWS Budgets** alert (50/80/100%)

## Model note (important)

Claude **3.5 Haiku is not available in any EU region**, and Claude **3 Haiku is
now Legacy** (returns access-denied if unused for 30 days). The only working
Haiku in Frankfurt is **Claude Haiku 4.5**, invoked via the EU cross-region
inference profile `eu.anthropic.claude-haiku-4-5-20251001-v1:0` (it cannot be
called as a direct on-demand foundation model). That is the Terraform default.
The €5/month in-code spend guard still caps cost regardless of model.

## One-time prerequisites

1. **Create the bot** with [@BotFather](https://t.me/BotFather); save the token.
   Run `/setprivacy` → **Disable**, so the bot sees group mentions/replies.
2. **Enable Bedrock model access** for *Claude Haiku 4.5* in eu-central-1:
   Bedrock console → Model access → enable Anthropic Claude Haiku 4.5.
   (Verify: the deploy step below test-invokes it.)

## Deploy

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars   # then edit: bot token, username
export ASDF_TERRAFORM_VERSION=1.5.1            # only if using asdf

terraform init
terraform apply
```

Outputs:

```bash
terraform output function_url                  # the webhook target
terraform output -raw telegram_secret_token    # secret token (generated)
```

## Wire up the Telegram webhook

```bash
BOT_TOKEN='<from BotFather>'
URL="$(terraform output -raw function_url)"
SECRET="$(terraform output -raw telegram_secret_token)"

# allowed_updates MUST include my_chat_member (the add-to-group event that
# triggers the admin approval DM) and callback_query (the approve/deny buttons).
# With only ["message"], access control can never prompt for approval.
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=${URL}" \
  -d "secret_token=${SECRET}" \
  --data-urlencode "allowed_updates=[\"message\",\"my_chat_member\",\"callback_query\"]"

curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

## Test in the real world

1. Add the bot to a Telegram group (or DM it). The admin gets a DM with
   approve/deny buttons. (DM the bot once first, or it can't message you.)
   Fallback if the DM never arrives: as the admin, type `/approve` in the group
   (or `/approve <chat_id>` from your DM with the bot).
2. `@your_bot_username سلام` — it should reply in Persian, threaded.
3. Reply to one of its messages — it should reply again.
4. Send unrelated messages — it should stay silent.

Watch logs:

```bash
aws logs tail "$(terraform output -raw log_group)" --follow \
  --region eu-central-1 --profile personal
```

## Tear down

```bash
terraform destroy
```
