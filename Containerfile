FROM docker.io/oven/bun:1
RUN apt-get update
RUN apt-get install -y --no-install-recommends \
    nodejs                                     \
    ca-certificates
RUN mkdir /app
WORKDIR /app
CMD ["bun", "run", "dev"]
