#!/bin/bash
# Run in CloudShell from the unpacked source folder: uploads the source to S3 and
# tells the instance (via SSM) to build and restart. Prints the deploy log.
set -euo pipefail
R=us-east-2
BUCKET=$(aws ssm get-parameter --name /pidready-infra/BUCKET --region $R --query Parameter.Value --output text)
SRC=${1:-$HOME/pidready.tar.gz}
aws s3 cp "$SRC" "s3://$BUCKET/pidready.tar.gz" --region $R --only-show-errors
IID=$(aws ec2 describe-instances --filters Name=tag:Name,Values=pidready Name=instance-state-name,Values=running --query 'Reservations[0].Instances[0].InstanceId' --output text --region $R)
CMD=$(aws ssm send-command --instance-ids $IID --document-name AWS-RunShellScript --region $R \
  --timeout-seconds 1800 \
  --parameters 'commands=["set -e","cd /opt/pidready","aws s3 cp s3://'"$BUCKET"'/pidready.tar.gz src.tgz --region us-east-2 --only-show-errors","rm -rf src && mkdir src && tar xzf src.tgz -C src --strip-components=1","bash src/infra/deploy.sh"]' \
  --query Command.CommandId --output text)
echo "Deploying (command $CMD)…"
while true; do
  S=$(aws ssm get-command-invocation --command-id $CMD --instance-id $IID --region $R --query Status --output text 2>/dev/null || echo Pending)
  case $S in Success|Failed|Cancelled|TimedOut) break;; esac
  sleep 10
done
aws ssm get-command-invocation --command-id $CMD --instance-id $IID --region $R --query '[StandardOutputContent,StandardErrorContent]' --output text | tail -40
echo "STATUS: $S"
