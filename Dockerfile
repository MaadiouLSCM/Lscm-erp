FROM node:18-alpine
WORKDIR /app
COPY Package.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
