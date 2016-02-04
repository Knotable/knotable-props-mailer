#!/usr/bin/env bash
if [[ $ROLE"" ]] ; then
  knotable_config=/conf/$DOMAIN_LONG-$ROLE.json
else
  knotable_config=/conf/$DOMAIN_LONG.json
fi

#settings consumed by node.js and meteor
export METEOR_SETTINGS=`cat $knotable_config`
export ROOT_URL='http://'$DOMAIN_LONG
export PORT=80
hostname $HOSTNAME

cd /built_app
mkdir -p /knotable-var/props_meteor_app

forever start                     \
  -a                              \
  -l /knotable-var/props_meteor_app/forever.log    \
  -e /knotable-var/props_meteor_app/forever.error  \
  main.js

tail -f /knotable-var/props_meteor_app/forever.log
