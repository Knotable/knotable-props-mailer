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
   exit
 fi



# Set up sudo for Linux
sudo='sudo'
if [ "$(uname)" == "Darwin" ]; then
  sudo=
fi



# Set up environment for Mac and Linux
if [ "$(uname)" == "Darwin" ]; then
  #check docker stuff
  source docker/docker_machine_setup.sh
  if [ $result"" == "Failure" ] ; then exit ; fi
else
  $sudo docker login -u knotable -p d0ckerP^55 -e knotable@m.eluck.me registry.knotable.com:443
fi




$sudo docker tag -f registry.knotable.com:443/meteord-webapp registry.knotable.com:443/meteord-old 2>/dev/null
$sudo docker pull registry.knotable.com:443/meteord-webapp
$sudo docker rmi -f registry.knotable.com:443/props_meteor_app
$sudo docker rmi registry.knotable.com:443/meteord-old 2>/dev/null
$sudo docker build -t registry.knotable.com:443/props_meteor_app -f docker/Dockerfile ./
