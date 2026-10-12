#!/bin/bash
# EC2 first boot: Docker, swap, folders. The app itself is installed by infra/deploy.sh.
set -eux
dnf install -y docker
systemctl enable --now docker
# 2 GB swap so builds don't run out of memory on a small instance.
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
mkdir -p /opt/pidready
