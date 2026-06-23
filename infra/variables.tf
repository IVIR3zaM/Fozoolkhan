# All inputs. Secrets (bot token) are marked sensitive and must be supplied via
# terraform.tfvars (gitignored) or TF_VAR_* env vars — never committed.

# ---- AWS / region -----------------------------------------------------------

variable "aws_region" {
  description = "AWS region to deploy into. Frankfurt by default."
  type        = string
  default     = "eu-central-1"
}

variable "aws_profile" {
  description = "Named AWS CLI profile to use for credentials."
  type        = string
  default     = "personal"
}

variable "name_prefix" {
  description = "Prefix for created resource names."
  type        = string
  default     = "fozoolkhan"
}

# ---- Telegram secrets -------------------------------------------------------

variable "telegram_bot_token" {
  description = "Bot token from @BotFather. Authenticates outgoing Bot API calls."
  type        = string
  sensitive   = true
}

variable "telegram_secret_token" {
  description = <<-EOT
    Secret token Telegram echoes back in the X-Telegram-Bot-Api-Secret-Token
    header so the Lambda can verify webhook authenticity. Leave empty to have
    Terraform generate a strong random value (exposed via the
    `telegram_secret_token` output).
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "bot_username" {
  description = "The bot's Telegram @username (without @), used to detect mentions."
  type        = string
  default     = "fozoolkhan"
}

variable "admin_user_id" {
  description = <<-EOT
    The admin's numeric Telegram user id. Access control: the bot answers only
    this user in private chats, DMs them to approve any group it's added to, and
    only this user can approve/deny groups. Find it via @userinfobot. The admin
    must DM the bot once so the approval message can be delivered.
  EOT
  type        = string
}

# ---- Bedrock model ----------------------------------------------------------

variable "bedrock_model_id" {
  description = <<-EOT
    Bedrock model (or inference-profile) id to invoke. Default is Claude Haiku 4.5
    via the EU cross-region inference profile — the only working Haiku in Frankfurt:
    Claude 3.5 Haiku isn't offered in any EU region, and Claude 3 Haiku is now a
    Legacy model that returns access-denied. Haiku 4.5 must be called through an
    inference profile (on-demand foundation-model invocation isn't supported).
  EOT
  type        = string
  default     = "eu.anthropic.claude-haiku-4-5-20251001-v1:0"
}

variable "max_response_tokens" {
  description = "Hard cap on Bedrock response length (token frugality)."
  type        = number
  default     = 300
}

variable "usd_to_eur" {
  description = <<-EOT
    USD->EUR factor applied to the model price catalog (src/pricing.js) when
    estimating spend and rendering the /usage comparison. ~0.92 means 1 USD ~=
    0.92 EUR. The catalog prices each model by BEDROCK_MODEL_ID, so changing the
    model re-prices spend automatically -- no need to touch the per-1K vars below.
  EOT
  type        = number
  default     = 0.92
}

variable "bedrock_input_price_per_1k_eur" {
  description = "Fallback per-1K input-token price (EUR), used ONLY for a model the price catalog doesn't recognize. Default matches Claude Haiku 4.5 ($1.00/M)."
  type        = number
  default     = 0.00092
}

variable "bedrock_output_price_per_1k_eur" {
  description = "Fallback per-1K output-token price (EUR), used ONLY for a model the price catalog doesn't recognize. Default matches Claude Haiku 4.5 ($5.00/M)."
  type        = number
  default     = 0.0046
}

# ---- Bot behaviour / budget -------------------------------------------------

variable "monthly_budget_eur" {
  description = "The #1 product requirement: monthly cost ceiling in euros. In-code spend guard refuses Bedrock once exceeded."
  type        = number
  default     = 5
}

variable "context_message_count" {
  description = "How many recent messages to include as context (never full history)."
  type        = number
  default     = 5
}

variable "obs_ttl_days" {
  description = "Days an append-only observation lives before DynamoDB TTL expires it."
  type        = number
  default     = 30
}

variable "obs_summary_threshold" {
  description = "How many observations accumulate before the occasional summarization step runs."
  type        = number
  default     = 8
}

# ---- Lambda sizing ----------------------------------------------------------

variable "lambda_memory_mb" {
  description = "Lambda memory size (MB)."
  type        = number
  default     = 256
}

variable "lambda_timeout_s" {
  description = "Lambda timeout (seconds). Generous enough for a Bedrock round-trip."
  type        = number
  default     = 30
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the Lambda log group."
  type        = number
  default     = 7
}

# ---- AWS Budgets alert (optional) -------------------------------------------

variable "budget_alert_email" {
  description = "Email for AWS Budgets alerts at 50/80/100%. Leave empty to skip creating the budget."
  type        = string
  default     = ""
}

variable "budget_limit_amount" {
  description = "AWS Budgets limit amount. Note: AWS Budgets bills in the account currency (usually USD); this is a notification only — the real brake is the in-code guard."
  type        = string
  default     = "5"
}

variable "budget_limit_currency" {
  description = "Currency unit for the AWS Budget (e.g. USD or EUR)."
  type        = string
  default     = "USD"
}
