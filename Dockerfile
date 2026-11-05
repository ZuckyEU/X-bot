FROM mcr.microsoft.com/playwright:v1.64.1-jammy
RUN apt-get update && apt-get install -y xvfb
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --production
COPY . .
ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
