# Device Farm — DevOps Deployment Guide

## Overview

This is a self-hosted Android device farm server that enables performance testing
with Flashlight on real physical devices. It exposes a REST API + WebSocket dashboard
and manages ADB connections to Android devices over WiFi.

---

## Option A — EC2 Deployment (Recommended for POC)

### Why EC2 over EKS
- ADB requires USB device passthrough or stable TCP connections — easier on a single EC2 instance
- No orchestration complexity for a single device farm node
- EKS makes sense only if you need multiple device farm nodes (10+ devices)

### EC2 Instance Requirements

| | Minimum | Recommended |
|---|---|---|
| Instance type | t3.medium | t3.large |
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB |
| Storage | 30 GB gp3 | 100 GB gp3 |
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |
| Architecture | x86_64 | x86_64 |

### Security Group Rules

| Port | Protocol | Source | Purpose |
|---|---|---|---|
| 22 | TCP | Your office IP only | SSH access |
| 80 | TCP | 0.0.0.0/0 | HTTP → HTTPS redirect |
| 443 | TCP | 0.0.0.0/0 | HTTPS dashboard + API |
| 3000 | TCP | Your office IP only | Direct API access (optional) |
| 5555 | TCP | 0.0.0.0/0 | ADB WiFi device connections |
| 4723 | TCP | Your office IP only | Appium server |

⚠️  Port 5555 must be open to 0.0.0.0/0 — this is how the physical Android
    device connects to the ADB server over the internet.

### IAM Role (attach to EC2 instance)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::your-device-farm-bucket",
        "arn:aws:s3:::your-device-farm-bucket/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer"
      ],
      "Resource": "*"
    }
  ]
}
```

### Deployment Steps

```bash
# 1. Launch EC2 instance (Ubuntu 22.04, t3.large, attach IAM role above)

# 2. SSH into instance
ssh -i your-key.pem ubuntu@<EC2_PUBLIC_IP>

# 3. Clone the repo
git clone <YOUR_REPO_URL> /opt/device-farm
cd /opt/device-farm

# 4. Run setup script
sudo bash scripts/ec2-setup.sh

# 5. Add SSL certificate (two options):
# Option A — Let's Encrypt (if you have a domain)
sudo certbot certonly --standalone -d device-farm.yourdomain.com
sudo cp /etc/letsencrypt/live/device-farm.yourdomain.com/fullchain.pem /etc/nginx/certs/cert.pem
sudo cp /etc/letsencrypt/live/device-farm.yourdomain.com/privkey.pem /etc/nginx/certs/key.pem

# Option B — Self-signed (for POC only)
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/nginx/certs/key.pem \
  -out /etc/nginx/certs/cert.pem \
  -subj "/CN=device-farm"

# 6. Start nginx
sudo nginx -t && sudo systemctl restart nginx

# 7. Verify everything is running
sudo systemctl status device-farm
sudo systemctl status appium
curl http://localhost:3000/api/stats
```

### Connecting a Physical Device

**From the device (Android 11+):**
1. Settings → Developer Options → Wireless Debugging → ON
2. Tap "Pair device with pairing code" → note IP, pairing port, code

**From your laptop (one-time pairing):**
```bash
# Set farm URL to point to EC2
export FARM_URL=https://<EC2_PUBLIC_IP>

# Pair the device (one-time)
adb pair <DEVICE_IP>:<PAIRING_PORT> <CODE>

# Connect the device to the EC2 ADB server
# SSH tunnel approach (most reliable):
ssh -i your-key.pem -L 5037:localhost:5037 ubuntu@<EC2_PUBLIC_IP> &
adb connect <DEVICE_IP>:<CONNECTION_PORT>

# Verify on EC2
ssh ubuntu@<EC2_PUBLIC_IP> "adb devices"
```

### Software Installed by Setup Script

| Software | Version | Purpose |
|---|---|---|
| Node.js | 20.x | Runtime |
| ADB | Latest | Device communication |
| Appium | Latest | Test automation server |
| UiAutomator2 | Latest | Android driver |
| Flashlight | Latest | Performance profiler |
| Nginx | Latest | Reverse proxy + SSL |
| Java 17 | 17 LTS | Required by Appium |

---

## Option B — EKS Deployment (For Scale)

### When to use EKS over EC2
- You need 10+ devices managed centrally
- You want auto-scaling and high availability
- You already have EKS infrastructure

### EKS Requirements

```yaml
Node requirements:
  instance_type: c5.2xlarge   # 8 vCPU, 16GB RAM per node
  node_label: device-farm=true
  privileged: true             # Required for USB passthrough
  ami: Amazon Linux 2 with USB support

Cluster add-ons:
  - AWS Load Balancer Controller
  - EBS CSI Driver (for PersistentVolumes)
  - cert-manager (for SSL)
```

### Build and Push Docker Image

```bash
# Build
docker build -t device-farm:latest .

# Tag and push to ECR
aws ecr create-repository --repository-name device-farm
ECR_URI=$(aws ecr describe-repositories \
  --repository-names device-farm \
  --query 'repositories[0].repositoryUri' \
  --output text)

aws ecr get-login-password | docker login --username AWS --password-stdin $ECR_URI
docker tag device-farm:latest $ECR_URI:latest
docker push $ECR_URI:latest

# Update k8s/deployment.yaml with your ECR URI
sed -i "s|YOUR_ECR_REGISTRY|$ECR_URI|g" k8s/deployment.yaml
```

### Deploy to EKS

```bash
# Label the node where the physical device will be connected
kubectl label node <NODE_NAME> device-farm=true

# Apply manifests
kubectl apply -f k8s/deployment.yaml

# Watch rollout
kubectl rollout status deployment/device-farm -n device-farm

# Get external URL
kubectl get svc device-farm-external -n device-farm
```

### EKS Gotchas

1. **USB passthrough** — USB devices only work with EC2 bare metal instances or
   nodes with USB passthrough enabled. Standard EKS managed nodes don't support this.
   Workaround: use WiFi ADB only (no USB), which works fine on EKS.

2. **Singleton deployment** — Always keep replicas: 1. ADB server can't be load
   balanced across multiple pods. If you need multiple device farms, use separate
   namespaces per farm, each with replicas: 1.

3. **PersistentVolume** — Use gp3 EBS volumes, not EFS. SQLite doesn't work well
   on NFS-based storage.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| PORT | 3000 | Server port |
| NODE_ENV | production | Environment |
| ADB_SERVER_SOCKET | tcp:5037 | ADB server address |
| FARM_SECRET | - | API auth token (add this for production) |

---

## Health Checks

```bash
# Server health
curl https://<HOST>/api/stats

# Devices connected
curl https://<HOST>/api/devices

# Appium health
curl http://localhost:4723/status

# ADB devices
adb -H <HOST> -P 5037 devices
```

---

## Monitoring (Optional)

Add these to your existing monitoring stack:

```bash
# Prometheus metrics endpoint (add to server/index.js if needed)
GET /metrics

# Key metrics to alert on:
# - device_farm_devices_connected < 1  (no devices)
# - device_farm_jobs_failed > 5        (too many failures)
# - process_heap_used > 2GB            (memory leak)
```

---

## CI/CD Integration

```yaml
# .github/workflows/perf-test.yml
- name: Run performance tests
  env:
    FARM_URL: https://device-farm.yourdomain.com
  run: |
    node cli/index.js run \
      -p com.yourapp \
      -a app-release.apk \
      --activity .MainActivity \
      --name "PR #${{ github.event.number }}" \
      --branch "${{ github.ref_name }}" \
      --commit "${{ github.sha }}"
```

---

## Security Checklist for Production

- [ ] Restrict port 3000 to VPN/office IP only — never expose publicly
- [ ] Restrict port 4723 (Appium) to internal only
- [ ] Add API key auth to device farm server (add `FARM_SECRET` env var)
- [ ] Enable SSL on Nginx with valid certificate (not self-signed)
- [ ] Store APKs in S3, not on EC2 disk
- [ ] Enable EC2 instance termination protection
- [ ] Set up CloudWatch alarms for disk space (reports can be large)
- [ ] Rotate SSH keys regularly
- [ ] Keep ADB server logs — they contain device connection history

---

## What to tell your DevOps team

> We need an EC2 instance (t3.large, Ubuntu 22.04) to host a self-hosted Android
> device farm for performance testing. The setup script handles all software
> installation automatically. We need:
>
> 1. EC2 t3.large in a public subnet with the security group rules above
> 2. An Elastic IP so the address doesn't change
> 3. An IAM role with S3 + ECR read access
> 4. A subdomain pointing to the instance (e.g. device-farm.internal.yourcompany.com)
> 5. SSL certificate via ACM or Let's Encrypt
>
> The server hosts Appium + ADB + our custom orchestration layer.
> Physical Android test devices connect to it over WiFi ADB (port 5555).
> The dashboard is accessible via HTTPS from any browser.
> No sensitive customer data is stored — only test APKs and performance reports.
