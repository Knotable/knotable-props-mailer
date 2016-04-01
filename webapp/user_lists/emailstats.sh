echo "[cronjob emailstats.sh] - Start `date`" >> /knotable-var/cron.log 2>&1

# Email params
from="robot@knotable.com"
to="mariasusanasescon@gmail.com"
cc1="maria4knote@gmail.com"
cc2="richard@knote.com"
subject="Daily Email Stats -- $(date -d "yesterday 13:00 " '+%Y-%m-%d')"
apikey="key-ed04bdc21ac899b587517a9038f0639a"

day=$(date -d "yesterday 13:00 " '+%d')
month=$(date -d "yesterday 13:00 " '+%b')

opens=$(curl -s --user 'api:'${apikey} -G -d "groupby=day" https://api.mailgun.net/v3/props.knotable.com/campaigns/knoteblogapril/opens | tr '}' '\n' | grep "$day $month")
clicks=$(curl -s --user 'api:'${apikey} -G -d "groupby=link&groupby=day" https://api.mailgun.net/v3/props.knotable.com/campaigns/knoteblogapril/clicks | tr '}' '\n' | grep "$day $month")
knotableopens=$(curl -s --user 'api:'${apikey} -G -d "groupby=day" https://api.mailgun.net/v3/props.knotable.com/campaigns/knotablewapr/opens | tr '}' '\n' | grep "$day $month")
knotableclicks=$(curl -s --user 'api:'${apikey} -G -d "groupby=link&groupby=day" https://api.mailgun.net/v3/props.knotable.com/campaigns/knotablewapr/clicks | tr '}' '\n' | grep "$day $month")

body="Reading campaigns knotablewapr & knoteblogapril
for $(date -d "yesterday 13:00 " '+%Y-%m-%d')
Knote Opens = ${opens}
Knote Clicks = ${clicks}
Knotable Opens = ${knotableopens}
Knotable Clicks = ${knotableclicks}"

echo "Sending email..."
curl -s --user "api:${apikey}" \
  https://api.mailgun.net/v3/knotable.com/messages \
  -F from="${from}" \
  -F to="${to}" \
  -F cc="${cc1}, ${cc2}" \
  -F subject="${subject}" \
  -F text="${body}" \\

echo "[cronjob emailstats.sh] - Finish `date`" >> /knotable-var/cron.log 2>&1
