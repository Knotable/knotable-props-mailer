FROM registry.knotable.com:443/meteord-webapp-1.4.0.1
MAINTAINER Knotable

ENV COMMIT_HASH=KNOTEL_COMMIT_HASH
VOLUME /logs

ADD ./conf  /conf
ADD ./webapp /app


RUN   cd /app                                   && \
      meteor npm install --production           && \
      meteor build --directory /tmp/the-app     && \
      rm -rf /app/.meteor/local                 && \
      cd /tmp/the-app/bundle/programs/server/   && \
      npm install --save                        && \
      cd /                                      && \
      mv /tmp/the-app/bundle /built_app         && \
      rm -rf /tmp/the-app                       && \
      rm -rf /app/node_modules

CMD /conf/start_instance.sh
