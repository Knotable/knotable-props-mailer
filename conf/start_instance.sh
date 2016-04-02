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


# Setting up the cron job
# cron
# yes | cp /app/user_lists/cronjob /etc/cron.d/cronjob
# chmod 0644 /etc/cron.d/cronjob
# touch /knotable-var/cron.log
# crontab -u root /etc/cron.d/cronjob

tail -f /knotable-var/props_meteor_app/forever.log
