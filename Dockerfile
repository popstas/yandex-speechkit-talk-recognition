FROM node:16-alpine AS builder

WORKDIR /build
COPY package*.json ./
RUN npm install

# RUN chown -R node:node /app
# USER node

FROM node:16-alpine

RUN apk add  --no-cache ffmpeg

WORKDIR /app
COPY --from=builder /build/node_modules ./node_modules
COPY . .
VOLUME ["/app/data"]
EXPOSE 5771
ENV PORT=5771
ENV NODE_ENV production

CMD  ["npm", "run", "server"]
