# Use Node.js official Alpine image for small size
FROM node:18-alpine

# Set working directory inside container
WORKDIR /app

# Copy dependency definitions first (for better layer caching)
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy rest of your application code
COPY . .

# Copy the .env file into the container
COPY .env .env

# Expose the port your app runs on
EXPOSE 8000

# Start your Node.js server
CMD ["node", "server.js"]
