FROM mcr.microsoft.com/playwright:v1.64.1-jammy
RUN apt-get update && apt-get install -y xvfb
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
ENV NODE_ENV=production
CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x1024x24", "node", "server.js"]
