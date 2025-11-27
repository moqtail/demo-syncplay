FROM node:22-slim

# Set working directory
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --prefer-offline --no-audit --progress=false

# Copy application source
COPY . .

# Expose application port
EXPOSE 8080

# Start the application
CMD ["npm", "run", "dev"]