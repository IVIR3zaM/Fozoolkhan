data "aws_caller_identity" "current" {}

locals {
  table_name    = var.name_prefix
  function_name = var.name_prefix
  # Use the provided secret token, or fall back to the generated one.
  secret_token = var.telegram_secret_token != "" ? var.telegram_secret_token : random_password.secret_token.result
}

# A generated secret token, used only when the caller didn't supply one. Telegram
# echoes it back in a header so the Lambda can verify webhook authenticity.
resource "random_password" "secret_token" {
  length  = 48
  special = false # Telegram restricts this header to A-Z a-z 0-9 _ -
}

# -----------------------------------------------------------------------------
# DynamoDB: single on-demand table. PK/SK string keys; TTL on `ttl` so
# append-only observations auto-expire. See ARCHITECTURE.md for the item shapes.
# -----------------------------------------------------------------------------
resource "aws_dynamodb_table" "state" {
  name         = local.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = false # tiny, reconstructable state — keep it cheap.
  }
}

# -----------------------------------------------------------------------------
# Package the Lambda. The nodejs20.x runtime bundles AWS SDK v3, so we ship only
# our source + package.json (for "type":"module"). A staging dir is assembled so
# the handler resolves at the zip root as `index.handler`.
# -----------------------------------------------------------------------------
resource "null_resource" "build" {
  triggers = {
    index    = filemd5("${path.module}/../src/index.js")
    db       = filemd5("${path.module}/../src/db.js")
    bedrock  = filemd5("${path.module}/../src/bedrock.js")
    names    = filemd5("${path.module}/../src/names.js")
    telegram = filemd5("${path.module}/../src/telegram.js")
    pkg      = filemd5("${path.module}/../package.json")
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -e
      rm -rf "${path.module}/build"
      mkdir -p "${path.module}/build"
      cp "${path.module}"/../src/*.js "${path.module}/build/"
      cp "${path.module}/../package.json" "${path.module}/build/"
    EOT
  }
}

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/build"
  output_path = "${path.module}/lambda.zip"
  depends_on  = [null_resource.build]
}

# -----------------------------------------------------------------------------
# IAM: least-privilege role for the Lambda. DynamoDB on the one table, Bedrock
# invoke on Anthropic models + EU inference profiles, and its own log group.
# -----------------------------------------------------------------------------
resource "aws_iam_role" "lambda" {
  name = "${var.name_prefix}-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role_policy" "lambda" {
  name = "${var.name_prefix}-policy"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Logs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "${aws_cloudwatch_log_group.lambda.arn}:*"
      },
      {
        Sid    = "DynamoDB"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
        ]
        Resource = aws_dynamodb_table.state.arn
      },
      {
        Sid    = "BedrockInvoke"
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
        ]
        # Foundation models (any region, for direct + cross-region routing) and
        # this account's inference profiles. Scoped to Anthropic models.
        Resource = [
          "arn:aws:bedrock:*::foundation-model/anthropic.*",
          "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*",
        ]
      },
    ]
  })
}

# -----------------------------------------------------------------------------
# The Lambda + a public Function URL (no API Gateway — saves cost). The URL is
# unauthenticated at the AWS layer; the handler verifies Telegram's secret token
# header on every request.
# -----------------------------------------------------------------------------
resource "aws_lambda_function" "bot" {
  function_name    = local.function_name
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  architectures    = ["arm64"]
  memory_size      = var.lambda_memory_mb
  timeout          = var.lambda_timeout_s
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256

  environment {
    variables = {
      DDB_TABLE_NAME                  = aws_dynamodb_table.state.name
      TELEGRAM_BOT_TOKEN              = var.telegram_bot_token
      TELEGRAM_SECRET_TOKEN           = local.secret_token
      BOT_USERNAME                    = var.bot_username
      BEDROCK_MODEL_ID                = var.bedrock_model_id
      MAX_RESPONSE_TOKENS             = tostring(var.max_response_tokens)
      MONTHLY_BUDGET_EUR              = tostring(var.monthly_budget_eur)
      CONTEXT_MESSAGE_COUNT           = tostring(var.context_message_count)
      OBS_TTL_DAYS                    = tostring(var.obs_ttl_days)
      OBS_SUMMARY_THRESHOLD           = tostring(var.obs_summary_threshold)
      BEDROCK_INPUT_PRICE_PER_1K_EUR  = tostring(var.bedrock_input_price_per_1k_eur)
      BEDROCK_OUTPUT_PRICE_PER_1K_EUR = tostring(var.bedrock_output_price_per_1k_eur)
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

resource "aws_lambda_function_url" "bot" {
  function_name      = aws_lambda_function.bot.function_name
  authorization_type = "NONE"
}

# -----------------------------------------------------------------------------
# AWS Budgets alert (optional — created only if an email is supplied). A
# notification layer; the in-code spend guard is the real brake.
# -----------------------------------------------------------------------------
resource "aws_budgets_budget" "monthly" {
  count        = var.budget_alert_email != "" ? 1 : 0
  name         = "${var.name_prefix}-monthly"
  budget_type  = "COST"
  limit_amount = var.budget_limit_amount
  limit_unit   = var.budget_limit_currency
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = [50, 80, 100]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.budget_alert_email]
    }
  }
}
