#!/usr/bin/env bash

root_directory=`git rev-parse --show-toplevel 2>/dev/null`
if [ ! `pwd` == $root_directory ] ; then
  echo -e "\nChanging to root directory: $root_directory"
  cd $root_directory
fi

declare -a servers=(
  "props.knote.com"
)

key=~/.ssh/beta-omega.pem

DomainLong=props.knote.com


function launchServiceOnServer {
  echo "
      Launching props_meteor_app on $1
  "
  ssh -i $key ubuntu@$1 bash -c "                                       \
    echo 'Logging in...'                                            ;   \
    sudo docker login -u knotable -p d0ckerP^55 registry.knotable.com:443                                         &&  \
    sudo docker tag registry.knotable.com:443/props_meteor_app registry.knotable.com:443/props_meteor_app:old     ;   \
    sudo docker pull registry.knotable.com:443/props_meteor_app     &&  \
                                                                        \
    sudo docker rm -f props_meteor_app-mongo &> /dev/null           ;   \
    sleep 2                                                         ;   \
    sudo docker run -d                                                  \
      --name props_meteor_app-mongo                                     \
      -v /knotable-var/props_db:/data/db                                \
      mongo:2.6 mongod --smallfiles                                 &&  \
                                                                        \
    sudo docker rm -f props_meteor_app &> /dev/null                 ;   \
    sleep 2                                                         ;   \
    sudo docker run -d                                                  \
        --name props_meteor_app                                         \
        --hostname $1                                                   \
        -e PORT=3000                                                    \
        -e ROOT_URL='http://$DomainLong'                                \
        -e METEOR_SETTINGS='$(cat conf/"$DomainLong.json")'             \
        -e MONGO_URL='mongodb://props_meteor_app-mongo'                 \
        -p 80:3000                                                      \
        --restart always                                                \
        --link props_meteor_app-mongo:props_meteor_app-mongo            \
        -v /knotable-var:/logs                                          \
        registry.knotable.com:443/props_meteor_app /bin/sh -c 'node main.js 1>>/logs/forever.log 2>&1' ; \
    sudo docker rmi registry.knotable.com:443/props_meteor_app:old
  "
}

for server in "${servers[@]}"
do
  launchServiceOnServer "$server"
done
