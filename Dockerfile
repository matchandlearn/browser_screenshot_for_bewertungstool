FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js ./

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
