#!/usr/bin/env bash

#set up sudo for Linux
sudo=sudo
if [ "$(uname)" == "Darwin" ]; then
  sudo=
fi


aws ecr get-login-password --region us-east-1 \
| $sudo docker login --username AWS --password-stdin 149172093612.dkr.ecr.us-east-1.amazonaws.com

$sudo docker push 149172093612.dkr.ecr.us-east-1.amazonaws.com/props-app:latest
