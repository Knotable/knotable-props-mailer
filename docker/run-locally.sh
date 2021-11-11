#!/usr/bin/env bash

root_directory=`git rev-parse --show-toplevel 2>/dev/null`
if [ ! `pwd` == $root_directory ] ; then
  echo -e "\nChanging to root directory: $root_directory"
  cd $root_directory
fi

#set up sudo for Linux
sudo=sudo
if [ "$(uname)" == "Darwin" ]; then
  sudo=
fi

$sudo docker rm -f props_meteor_app-mongo &> /dev/null
$sudo docker run --name props_meteor_app-mongo -d mongo:2.6 mongod --smallfiles

$sudo docker rm -f props_meteor_app &> /dev/null
$sudo docker run -d                                                 \
    --name props_meteor_app                                         \
    -e PORT=3000                                                    \
    -e ROOT_URL='http://localhost:3000'                             \
    -e METEOR_SETTINGS="$(cat conf/localhost.com.json)"             \
    -e MONGO_URL='mongodb://props_meteor_app-mongo'                 \
    -p 3000:3000                                                    \
    --link props_meteor_app-mongo:props_meteor_app-mongo            \
    registry.knotable.com:443/props_meteor_app

echo -e "\nTo see how this build works, open in browser"
echo -e "http://localhost:3000 \n"
echo "To stop the whole thing, use the following command:"
echo "sudo docker rm -f \`sudo docker ps -aq\`"
echo -e "\nServer logs can be found in ~/knotable-var directory\n"
