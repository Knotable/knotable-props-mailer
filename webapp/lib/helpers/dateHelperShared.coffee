@DateHelperShared =
  from_minutes : (currentDate, minutes) ->
    date = new Date(currentDate)
    date.setMinutes(currentDate.getMinutes() + minutes)
    date