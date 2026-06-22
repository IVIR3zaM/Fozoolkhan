# AWS provider. Region defaults to Frankfurt (eu-central-1) and credentials come
# from the named CLI profile (default "personal"). Override via variables.

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project   = "fozoolkhan"
      ManagedBy = "terraform"
    }
  }
}
