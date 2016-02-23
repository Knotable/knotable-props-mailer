@DateHelperShared =
  from_minutes : (currentDate, minutes) ->
    date = new Date(currentDate)
    date.setMinutes(currentDate.getMinutes() + minutes)
    date



  getCountDown: (date) ->
    duration = moment.duration(moment(date).diff(moment()))

    countDown = ("0"+duration.minutes()).slice(-2) + ":" + ("0"+duration.seconds()).slice(-2)
    if(duration.hours())
      countDown = ("0"+duration.hours()).slice(-2) + ":" + countDown

    if(duration.days())
      countDown = ("0"+duration.days()).slice(-2) + ":" + countDown

    return countDown
