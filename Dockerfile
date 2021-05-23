FROM node:12

WORKDIR /app
# COPY . .
COPY package*.json ./

# RUN chown -R node:node /app
# USER node

RUN npm install

VOLUME ["/app/data/data"]
EXPOSE 5771
ENV PORT=5771

CMD  ["npm", "run", "server"]
