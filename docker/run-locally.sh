#!/usr/bin/env bash



# set up docker-machine for Mac
if [ "$(uname)" == "Darwin" ]; then
  eval `docker-machine env dev`
fi



#set up sudo for Linux
sudo=sudo
if [ "$(uname)" == "Darwin" ]; then
  sudo=
fi



$sudo docker rm -f props_meteor_app-mongo &> /dev/null
$sudo docker run --name props_meteor_app-mongo -d mongo:2.6 mongod --smallfiles


$sudo docker rm -f props_meteor_app &> /dev/null

$sudo docker run -it                                                      \
    --name props_meteor_app                                         \
    -e DOMAIN_LONG=localhost.com                                    \
    -e MONGO_URL='mongodb://props_meteor_app-mongo'                 \
    -e HOSTNAME=localhost.com                                       \
    -p 3000:80                                                      \
    --link props_meteor_app-mongo:props_meteor_app-mongo            \
    -v ~/knotable-var:/logs                                         \
    registry.knotable.com:443/props_meteor_app



if [ "$(uname)" == "Darwin" ]; then
  echo -e "\nTo see how this buld works, open in browser\n"
  echo -e "http://`docker-machine ip dev`:$port \n"
  echo "To stop the whole thing, use the following command:"
  echo "eval \`docker-machine env dev\` && docker rm -f \`docker ps -aq\`"
  echo -e "\nServer logs can be found in ~/knotable-var directory\n"
else
  echo -e "\nTo see how this build works, open in browser"
  echo -e "http://localhost:$port \n"
  echo "To stop the whole thing, use the following command:"
  echo "sudo docker rm -f \`sudo docker ps -aq\`"
  echo -e "\nServer logs can be found in ~/knotable-var directory\n"
fi
