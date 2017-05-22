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

cd /built_app

mkdir -p /logs/props-mailer

/opt/nodejs/bin/forever start     \
  -a                              \
  -l /logs/props-mailer/forever.log     \
  -e /logs/props-mailer/forever.error   \
  main.js

tail -f /logs/props-mailer/forever.log
