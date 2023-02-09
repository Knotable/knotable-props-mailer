#!/usr/bin/env bash

root_directory=`git rev-parse --show-toplevel 2>/dev/null`
if [ ! `pwd` == $root_directory ] ; then
  echo -e "\nChanging to root directory: $root_directory"
  cd $root_directory
fi

declare -a servers=(
  "props.knote.com"
)

DomainLong=props.knote.com

image="$REGISTRY/props-app"

function launchServiceOnServer {
  echo "
      Launching props_meteor_app on $1
  "
  ssh -i $SSH_KEY_PATH ec2-user@$1 bash -c "                            \
    echo 'Logging in...'                                            ;   \
    sudo docker login -u $REGISTRY_USER -p $REGISTRY_PASS $REGISTRY &&  \
    sudo docker tag $image $image:old                               ;   \
    sudo docker pull $image:$IMAGE_TAG                              &&  \
                                                                        \
    echo 'Stopping old containers'                                            ;   \
    sudo docker rm -f props_meteor_app-mongo &> /dev/null           ;   \
    sudo docker rm -f props_meteor_app &> /dev/null                 ;   \
    sleep 2                                                         ;   \
    echo 'Run DB'                                            ;   \
    sudo docker run -d                                                  \
      --name props_meteor_app-mongo                                     \
      -v /knotable-var/props_db:/data/db                                \
      mongo:2.6 mongod --smallfiles                                 &&  \
                                                                        \
    sudo docker rmi $image:old
  "
}

for server in "${servers[@]}"
do
  launchServiceOnServer "$server"
done
