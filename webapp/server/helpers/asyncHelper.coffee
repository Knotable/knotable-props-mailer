@AsyncHelper =
  map: (items, iterator) ->
    return [] if _.isEmpty items
    internalIterator = (item, callback) ->
      Meteor.defer Meteor.bindEnvironment ->
        try
          callback null, iterator item
        catch err
          callback err

    return Promise.await(
      new Promise((resolve, reject) ->
        async.map items, internalIterator, (err, mappedItems) ->
          if err
            reject(err)
          else
            resolve(mappedItems)
      )
    )



  each: (items, iterator) ->
    AsyncHelper.map items, iterator
    items
