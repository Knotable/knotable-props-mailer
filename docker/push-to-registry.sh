#!/usr/bin/env bash

boot2docker start && eval `boot2docker shellinit`
docker login -u knotable -p d0ckerP^55 -e knotable@m.eluck.me registry.knotable.com:443
docker push registry.knotable.com:443/props_meteor_app
