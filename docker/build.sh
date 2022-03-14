#!/usr/bin/env bash



# Smart workdir handling :)
root_directory=`git rev-parse --show-toplevel 2>/dev/null`
if [ -z $root_directory"" ] ; then
  echo -e "\nYou are not in a knotable-props-mailer project directory."
  echo    "Please cd into it and run this script again."
  echo -e "Aborting...\n"
  exit
fi


if [ ! `pwd` == $root_directory ] ; then
  echo -e "\nChanging to root directory: $root_directory"
  cd $root_directory
fi



 #Check whether the repo is clean
 if [ "`git status -s`" ] ; then
   echo -e "\nThe repository is not clean."
   echo "Please make sure you committed all your changes and run this script again."
   echo -e "Aborting...\n"
#   exit
 fi



# Set up sudo for Linux
sudo='sudo'
if [ "$(uname)" == "Darwin" ]; then
  sudo=
fi



aws ecr get-login-password --region us-east-1 \
| $sudo docker login --username AWS --password-stdin 149172093612.dkr.ecr.us-east-1.amazonaws.com

$sudo docker build -t 149172093612.dkr.ecr.us-east-1.amazonaws.com/props-app -f docker/Dockerfile ./
