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



$sudo docker login -u knotable -p d0ckerP^55 -e knotable@m.eluck.me registry.knotable.com:443
$sudo docker push registry.knotable.com:443/props_meteor_app
