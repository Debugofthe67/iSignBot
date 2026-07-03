FROM node:20-slim

# Install core utilities AND ca-certificates so curl can securely connect to GitHub
RUN apt-get update && apt-get install -y \
    curl \
    tar \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Download pre-compiled binary release, unpack, and move to system paths
WORKDIR /opt
RUN curl -L https://github.com/zhlynn/zsign/releases/download/v1.0.4/zsign-linux-x86_64.tar.gz -o zsign.tar.gz \
    && tar -xzf zsign.tar.gz \
    && mv zsign /usr/local/bin/zsign \
    && chmod +x /usr/local/bin/zsign \
    && rm zsign.tar.gz

# Set up our workspace
WORKDIR /app
COPY . .

# Expose the network port Render expects
EXPOSE 3000

# AUTOMATION ENGINE: Automatically finds server.js, enters its directory, 
# installs dependencies right there, and spins up the backend!
CMD TARGET_DIR=$(dirname $(find . -name "server.js" | head -n 1)) && \
    cd "$TARGET_DIR" && \
    echo "Starting iSignBot in directory: $TARGET_DIR" && \
    npm install && \
    node server.js
