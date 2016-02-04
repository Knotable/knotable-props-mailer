#!/usr/bin/env bash

boot2docker start && eval `boot2docker shellinit`

docker rm -f props_meteor_app-mongo &> /dev/null
docker run --name props_meteor_app-mongo -d mongo:2.6 mongod --smallfiles


docker rm -f props_meteor_app &> /dev/null
echo "

   Find the app at

   http://`boot2docker ip`:3000

"
docker run -it                                                      \
    --name props_meteor_app                                         \
    -e DOMAIN_LONG=localhost.com                                    \
    -e MONGO_URL='mongodb://props_meteor_app-mongo'                 \
    -e HOSTNAME=localhost.com                                       \
    -p 3000:80                                                      \
    --link props_meteor_app-mongo:props_meteor_app-mongo            \
    -v ~/knotable-var:/logs                                         \
    registry.knotable.com:443/props_meteor_app
