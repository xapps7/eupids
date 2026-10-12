#!/bin/bash
# Run ONCE in AWS CloudShell (us-east-2). Creates: S3 bucket for releases, an EC2
# t3a.small with an instance role (SSM + S3 read + Parameter Store read), a security
# group for 80/443, an Elastic IP, and the Parameter Store entries the app reads.
# Secrets are created as placeholders ("CHANGE_ME"); paste real values in the console.
set -euo pipefail
R=us-east-2
ACC=$(aws sts get-caller-identity --query Account --output text)
BUCKET="pidready-releases-$ACC"
aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null || aws s3api create-bucket --bucket "$BUCKET" --region $R --create-bucket-configuration LocationConstraint=$R >/dev/null
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws ssm put-parameter --name /pidready-infra/BUCKET --type String --value "$BUCKET" --overwrite --region $R >/dev/null

cat > /tmp/ec2-trust.json <<J
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
J
aws iam get-role --role-name pidready-ec2 >/dev/null 2>&1 || aws iam create-role --role-name pidready-ec2 --assume-role-policy-document file:///tmp/ec2-trust.json >/dev/null
aws iam attach-role-policy --role-name pidready-ec2 --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
cat > /tmp/ec2-policy.json <<J
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["s3:GetObject"],"Resource":"arn:aws:s3:::$BUCKET/*"},
 {"Effect":"Allow","Action":["ssm:GetParameter","ssm:GetParameters","ssm:GetParametersByPath"],"Resource":["arn:aws:ssm:$R:$ACC:parameter/pidready/*","arn:aws:ssm:$R:$ACC:parameter/pidready","arn:aws:ssm:$R:$ACC:parameter/pidready-infra/*"]},
 {"Effect":"Allow","Action":"kms:Decrypt","Resource":"*","Condition":{"StringEquals":{"kms:ViaService":"ssm.$R.amazonaws.com"}}}]}
J
aws iam put-role-policy --role-name pidready-ec2 --policy-name pidready-app --policy-document file:///tmp/ec2-policy.json
aws iam get-instance-profile --instance-profile-name pidready-ec2 >/dev/null 2>&1 || { aws iam create-instance-profile --instance-profile-name pidready-ec2 >/dev/null; aws iam add-role-to-instance-profile --instance-profile-name pidready-ec2 --role-name pidready-ec2; sleep 12; }

VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text --region $R)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=pidready-web Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text --region $R)
if [ "$SG" = "None" ]; then
  SG=$(aws ec2 create-security-group --group-name pidready-web --description "PID Ready web 80/443" --vpc-id $VPC --region $R --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id $SG --protocol tcp --port 80 --cidr 0.0.0.0/0 --region $R >/dev/null
  aws ec2 authorize-security-group-ingress --group-id $SG --protocol tcp --port 443 --cidr 0.0.0.0/0 --region $R >/dev/null
fi

IID=$(aws ec2 describe-instances --filters Name=tag:Name,Values=pidready Name=instance-state-name,Values=pending,running,stopped --query 'Reservations[0].Instances[0].InstanceId' --output text --region $R)
if [ "$IID" = "None" ]; then
  AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text --region $R)
  IID=$(aws ec2 run-instances --image-id $AMI --instance-type t3a.small \
    --iam-instance-profile Name=pidready-ec2 --security-group-ids $SG \
    --user-data file://infra/userdata.sh \
    --metadata-options HttpTokens=required,HttpPutResponseHopLimit=2 \
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3}' \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=pidready}]' \
    --region $R --query 'Instances[0].InstanceId' --output text)
  aws ec2 wait instance-running --instance-ids $IID --region $R
fi
ALLOC=$(aws ec2 describe-addresses --filters Name=tag:Name,Values=pidready --query 'Addresses[0].AllocationId' --output text --region $R)
if [ "$ALLOC" = "None" ]; then
  ALLOC=$(aws ec2 allocate-address --region $R --tag-specifications 'ResourceType=elastic-ip,Tags=[{Key=Name,Value=pidready}]' --query AllocationId --output text)
fi
aws ec2 associate-address --instance-id $IID --allocation-id $ALLOC --region $R >/dev/null
IP=$(aws ec2 describe-addresses --allocation-ids $ALLOC --region $R --query 'Addresses[0].PublicIp' --output text)
HOST="$(echo $IP | tr . -).sslip.io"

put() { aws ssm put-parameter --name "/pidready/$1" --type "$2" --value "$3" --overwrite --region $R >/dev/null; }
putnew() { aws ssm get-parameter --name "/pidready/$1" --region $R >/dev/null 2>&1 || put "$1" "$2" "$3"; }
put SHOPIFY_APP_URL String "https://$HOST"
put APP_HOST String "$HOST"
put SCOPES String "read_products,write_products,read_inventory,write_inventory"
putnew BILLING_TEST String "true"
putnew SHOPIFY_API_KEY String "CHANGE_ME"
putnew SHOPIFY_API_SECRET SecureString "CHANGE_ME"
putnew DATABASE_URL SecureString "CHANGE_ME"
putnew DIRECT_URL SecureString "CHANGE_ME"
# Generated here, never shown. Do not change after launch (session tokens are encrypted with it).
putnew TOKEN_ENCRYPTION_KEY SecureString "$(openssl rand -hex 32)"

echo "SETUP OK instance=$IID ip=$IP url=https://$HOST bucket=$BUCKET"
