FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY prisma ./prisma/
COPY src ./src/

RUN ./node_modules/.bin/prisma generate
RUN npm run build

EXPOSE 8080

CMD ./node_modules/.bin/prisma migrate deploy && node dist/main.js

