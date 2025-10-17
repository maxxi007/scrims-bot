# Dockerfile for Farlight 84 Scrims Bot
FROM node:20-bullseye

# Install system deps for canvas
RUN apt-get update && apt-get install -y \
    build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package.json package-lock.json* ./

RUN npm install --production

COPY . .

EXPOSE 8080

CMD ["npm", "start"]
