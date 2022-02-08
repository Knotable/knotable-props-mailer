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



$sudo docker login -u knotable -p d0ckerP^55 registry.knotable.com:443
$sudo docker rmi -f registry.knotable.com:443/props_meteor_app
$sudo docker build -t registry.knotable.com:443/props_meteor_app -f docker/Dockerfile ./
