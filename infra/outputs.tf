output "function_url" {
  description = "Public Lambda Function URL. Set this as the Telegram webhook."
  value       = aws_lambda_function_url.bot.function_url
}

output "telegram_secret_token" {
  description = "Secret token to pass to setWebhook (secret_token param). Verified on every request."
  value       = local.secret_token
  sensitive   = true
}

output "dynamodb_table" {
  description = "DynamoDB table name."
  value       = aws_dynamodb_table.state.name
}

output "lambda_function_name" {
  description = "Lambda function name (for logs / updates)."
  value       = aws_lambda_function.bot.function_name
}

output "log_group" {
  description = "CloudWatch log group for the Lambda."
  value       = aws_cloudwatch_log_group.lambda.name
}
