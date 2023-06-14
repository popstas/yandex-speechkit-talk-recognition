FROM node:18-alpine AS builder

WORKDIR /build
COPY package*.json ./
#RUN chown -R node:node .
#USER node
RUN npm install


# stage 2
FROM node:18-alpine

RUN apk add  --no-cache ffmpeg

WORKDIR /app
COPY --from=builder /build/node_modules ./node_modules
COPY . .

#USER node
#RUN chown -R node:node /app/.nuxt

VOLUME ["/app/data"]
EXPOSE 5771
ENV PORT=5771
#ENV NODE_ENV production

CMD  ["npm", "run", "server"]
