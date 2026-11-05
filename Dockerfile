FROM mcr.microsoft.com/playwright:v1.44.0-jammy
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
ENV NODE_ENV=production
CMD ["npm", "run", "check:prod"]
