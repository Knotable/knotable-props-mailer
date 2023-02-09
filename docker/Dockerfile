FROM 149172093612.dkr.ecr.us-east-1.amazonaws.com/meteor-alpine:2.9.0 as builder

ENV METEOR_DISABLE_OPTIMISTIC_CACHING=1

USER meteor

RUN mkdir -p app

COPY --chown=meteor ./webapp  app

WORKDIR app

RUN meteor npm install --production --quiet

RUN meteor build --directory ../built-app

RUN cd ../built-app/bundle/programs/server \
    && npm install --production --quiet


FROM 149172093612.dkr.ecr.us-east-1.amazonaws.com/knote-runtime:2.9.0
LABEL maintainer="Knote <team@knote.com>"

COPY --from=builder /home/meteor/built-app/bundle /app

WORKDIR /app

CMD node main.js
