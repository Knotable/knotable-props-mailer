#!/usr/bin/env bash
declare -a servers=(
  "props.knotable.com"
)

cd ~/.ssh
key=beta-omega.pem

DomainLong=props.knotable.com


function launchServiceOnServer {
  echo "
      Launching props_meteor_app on $1
  "
  ssh -i $key ubuntu@$1 bash -c "                                       \
    echo 'Logging in...'                                            ;   \
    sudo docker login -u knotable -p d0ckerP^55 -e knotable@m.eluck.me registry.knotable.com:443                        &&  \
    sudo docker tag registry.knotable.com:443/props_meteor_app registry.knotable.com:443/props_meteor_app:old           ;   \
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
        -e DOMAIN_LONG=$DomainLong                                      \
        -e MONGO_URL='mongodb://props_meteor_app-mongo'                 \
        -e HOSTNAME=$1                                                  \
        -p 80:80                                                        \
        --link props_meteor_app-mongo:props_meteor_app-mongo            \
        -v /knotable-var:/logs                                          \
        registry.knotable.com:443/props_meteor_app                  ;   \
    sudo docker rmi registry.knotable.com:443/props_meteor_app:old
  "
}

for server in "${servers[@]}"
do
  launchServiceOnServer "$server"
done
