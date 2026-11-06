FROM mcr.microsoft.com/playwright:v1.64.1-jammy

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "run", "serve"]
