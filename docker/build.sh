#!/usr/bin/env bash

if [ "$(uname)" != "Darwin" ]; then
  echo "Linux is not supported yet. Aborting..."
  exit
fi


#smart workdir handling :)
root_directory=`git rev-parse --show-toplevel 2>/dev/null`
if [ -z $root_directory"" ] ; then
  echo "

      You are not in a knotable-ops project directory.
      Please cd into it and run this script again.
      Aborting...

  "
  exit
fi

if [ ! `pwd` == $root_directory ] ; then
  echo "changing to root directory: $root_directory/props_meteor_app"
  cd $root_directory/props_meteor_app
fi


#check whether the repo is clean
if [ "`git status -s`" ] ; then
  echo "
    The repository is not clean.
    Please make sure you committed all your changes and run this script again.
    Aborting...

  "
  exit
fi


boot2docker start && eval `boot2docker shellinit`
docker pull registry.knotable.com:443/meteord 2>/dev/null
docker rmi -f registry.knotable.com:443/props_meteor_app
docker build -t registry.knotable.com:443/props_meteor_app -f docker/Dockerfile ./
