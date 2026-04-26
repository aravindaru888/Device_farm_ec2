FROM node:20-slim

# Install ADB, Android platform tools, and dependencies
RUN apt-get update && apt-get install -y \
    android-tools-adb \
    curl \
    wget \
    unzip \
    openjdk-17-jdk \
    socat \
    && rm -rf /var/lib/apt/lists/*

# Install Appium globally
RUN npm install -g appium
RUN appium driver install uiautomator2

# Install Flashlight
RUN curl -Ls https://get.flashlight.dev -o /tmp/install.sh && bash /tmp/install.sh && rm /tmp/install.sh

WORKDIR /app

# Copy package files and install dependencies
COPY package.json .
RUN npm install

# Copy source
COPY server/ ./server/
COPY dashboard/ ./dashboard/
COPY cli/ ./cli/
COPY tests/ ./tests/
COPY scripts/ ./scripts/

# Create data directories
RUN mkdir -p data/uploads data/reports data/screenshots

# Start ADB server and app server
COPY scripts/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000 4723 5037

ENV PORT=3000
ENV NODE_ENV=production

ENTRYPOINT ["/entrypoint.sh"]
