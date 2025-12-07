FROM node:alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --prefer-offline --no-audit --progress=false

# Copy application source
COPY . .
RUN npm run build

# Expose application port
EXPOSE 8080

# Start the application
CMD ["npm", "run", "start"]