# Use Node.js official Alpine image for small size
# node:18-alpine can't satisfy this dependency tree's stated requirements —
# nodemailer@10 (bumped for a security fix) needs >=20.0.0, and sanitize-html's
# current resolved version needs >=22.12.0. Pinned to match the Node version
# this was actually developed and tested against, since Node's own `engines`
# field is advisory only — a lower version may or may not hard-crash depending
# on whether these packages hit an API Node 18/20 genuinely lacks, and that's
# not a gamble worth taking in production.
FROM node:22.17.0-alpine

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
