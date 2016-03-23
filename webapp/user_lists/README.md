User Lists Dump and Email
==========================

Dump the users' lists of below category and mails to `team@knote.com`

1. People who were invited but were never active.
2. People who signed up but were never active
3. People who were active but god deactivated.
4. People who are active.


## Cron job now runs inside `props_meteor_app` container.

Use `knotable-props-mailer/webapp/user_lists/cronjob` to update cronjob

Run following command to execute corrosponding job manually

```

docker exec props_meteor_app /bin/bash -c "/app/user_lists/export.sh"
docker exec props_meteor_app /bin/bash -c "/app/user_lists/emailstats.sh"

```
