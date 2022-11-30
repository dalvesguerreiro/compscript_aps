const express = require('express')
const { DateTime } = require('luxon')

const auth = require('./auth')
const activityCode = require('./activity_code')
const extension = require('./extension')
const pugFunctions = require('./pug_functions')

var router = express.Router()

compData = function(competition) {
  var out = {
    competition: competition,
    sortedSchedule: [],
    rooms: {},  // ID -> room
    events: {},  // ID -> event
    persons: {},  // ID -> person
    peoplePerRound: {},  // activity code (e.g. 333-r1) -> num people
  }

  competition.events.forEach((evt) => {
    out.events[evt.id] = evt
    for (var i = 0; i < evt.rounds.length - 1; i++) {
      var round = evt.rounds[i]
      if (round.advancementCondition && round.advancementCondition.type == 'ranking') {
        out.peoplePerRound[new activityCode.ActivityCode(evt.id, i + 2, null, null).id()] =
            round.advancementCondition.level
      }
    }
  })
  competition.persons.forEach((person) => {
    // TODO: limit to accepted registrations.
    if (person.registration) {
      person.registration.eventIds.forEach((eventId) => {
        var code = new activityCode.ActivityCode(eventId, 1, null, null).id()
        if (!out.peoplePerRound[code]) {
          out.peoplePerRound[code] = 0
        }
        out.peoplePerRound[code]++
      })
    }
    out.persons[person.wcaUserId] = person
  })

  var activities = []  // Array of {code -> {activities: [activities]}}, one per day

  var startDate = DateTime.fromISO(competition.schedule.startDate)
  for (var i = 0; i < competition.schedule.numberOfDays; i++) {
    activities.push({day: startDate.plus({days: i}), activities: new Map()})
  }

  competition.schedule.venues.forEach((venue) => {
    venue.rooms.forEach((room) => {
      out.rooms[room.id] = room
      room.activities.forEach((activity) => {
        activity.startTime = DateTime.fromISO(activity.startTime).setZone(venue.timezone)
        activity.endTime = DateTime.fromISO(activity.endTime).setZone(venue.timezone)
        var day = Math.floor(activity.startTime.diff(startDate, 'days').as('days'))
        if (!activities[day].activities.has(activity.activityCode)) {
          activities[day].activities.set(activity.activityCode, {activities: new Map()})
        }
        activities[day].activities.get(activity.activityCode).activities.set(room.id, activity)
      })
    })
  })
  activities.forEach((dayActivities) => {
    var dayActivityList = Array.from(dayActivities.activities.entries())
    dayActivityList.forEach((acts) => {
      var thisActivities = Array.from(acts[1].activities.entries()).map((e) => e[1])
      acts[1].activityCode = activityCode.parse(thisActivities[0].activityCode)
      acts[1].startTime = DateTime.min(...thisActivities.map((act) => act.startTime))
      acts[1].endTime = DateTime.max(...thisActivities.map((act) => act.endTime))
      acts[1].numGroups = Math.max(...thisActivities.map((act) => act.childActivities.length))
    })
    dayActivityList.sort((actsA, actsB) => {
      var aStart = actsA[1].startTime
      var bStart = actsB[1].startTime
      if (aStart < bStart) {
        return -1
      }
      if (aStart > bStart) {
        return 1
      }
      if (actsA[0] < actsB[0]) {
        return -1
      }
      if (actsA[0] > actsB[0]) {
        return 1
      }
      return 0
    })
    out.sortedSchedule.push({day: dayActivities.day, activities: dayActivityList.map((x) => x[1])})
  })

  return out
}

router.use('/:competitionId', async (req, res, next) => {
  try {
    req.competition = await auth.getWcaApi('/api/v0/competitions/' + req.params.competitionId + '/wcif', req, res)
    next()
  } catch (e) {
    res.redirect('/')
  }
})

router.get('/:competitionId', (req, res) => {
  res.render('competition', {comp: compData(req.competition), fn: pugFunctions})
})

router.get('/:competitionId/schedule', (req, res) => {
  res.render('schedule', {comp: compData(req.competition), fn: pugFunctions})
})

router.post('/:competitionId/schedule', async (req, res) => {
  var maxActivityId = 0
  req.competition.schedule.venues.forEach((venue) => {
    venue.rooms.forEach((room) => {
      room.activities.forEach((activity) => {
        maxActivityId = Math.max(maxActivityId, activity.id)
        activity.childActivities.forEach((childActivity) => {
          maxActivityId = Math.max(maxActivityId, childActivity.id)
          // Theoretically this could have more child activities, but in practice it won't.
        })
      })
    })
  })
  Object.entries(req.body).forEach(([key, value]) => {
    if (!key.endsWith('start')) {
      return
    }
    const keySplit = key.split('.')
    const date = keySplit[0]
    const activityCodeStr = keySplit[1]
    const activityCodeObj = activityCode.parse(activityCodeStr)
    const prefix = date + '.' + activityCodeStr + '.'
    const start = req.body[prefix + 'start']
    const end = req.body[prefix + 'end']
    const numGroups = +req.body[prefix + 'groups']
    req.competition.schedule.venues.forEach((venue) => {
      const activityStart = DateTime.fromFormat(date + ' ' + start, 'yyyyMMdd HH:mm', { zone: venue.zone})
      const activityEnd = DateTime.fromFormat(date + ' ' + end, 'yyyyMMdd HH:mm', { zone: venue.zone})
      venue.rooms.forEach((room) => {
        var roomActivity = null
        var roomActivityIdx = -1
        for (var idx = 0; idx < room.activities.length; idx++) {
          var activity = room.activities[idx]
          if (activity.activityCode !== activityCodeStr) {
            continue
          }
          if (DateTime.fromISO(activity.startTime).setZone(venue.timeZone).toFormat('yyyyMMdd') != date) {
            continue
          }
          roomActivity = activity
          roomActivityIdx = idx
        }
        const isActive = prefix + room.id + '.active' in req.body
        const adjustment = req.body[prefix + room.id + '.adjustment']
        if (roomActivity === null && isActive) {
          roomActivity = {
            id: ++maxActivityId,
            name: activityCodeObj.toString(),
            activityCode: activityCodeStr,
            childActivities: [],
            scrambleSetId: null,
            extensions: []
          }
          room.activities.push(roomActivity)
        } else if (roomActivity !== null && !isActive) {
          room.activities.splice(roomActivityIdx, 1)
        }
        if (!isActive) {
          return
        }
        extension.getExtension(roomActivity, 'Activity').adjustment = adjustment
        if (numGroups === 0) {
          roomActivity.startTime = activityStart.toISO()
          roomActivity.endTime = activityEnd.toISO()
          roomActivity.childActivities = []
          return
        }
        roomActivity.childActivities.splice(numGroups)
        while (roomActivity.childActivities.length < numGroups) {
          roomActivity.childActivities.push({
            id: ++maxActivityId,
            childActivities: [],
            scrambleSetId: null,
            extensions: []
          })
        }
        const groupLength = activityEnd.diff(activityStart, 'seconds') / numGroups
        for (var idx = 0; idx < roomActivity.childActivities.length; idx++) {
          var childActivity = roomActivity.childActivities[idx]
          var groupActivityCode = activityCodeObj.group(
              room.name.split(' ')[0] + (numGroups > 1 ? ' ' + (idx+1) : ''))
          childActivity.name = groupActivityCode.groupName
          childActivity.activityCode = groupActivityCode.id()
          childActivity.startTime = activityStart + groupLength * idx
          childActivity.endTime = activityStart + groupLength * (idx + 1)
        }
        [...adjustment.matchAll(/[+-]\d+/g)].forEach((adj) => {
          var delta = +adj.substring(1)
          if (adj.charAt(0) == '+') {
            roomActivity.childActivities.splice(0, delta)
          } else if (adj.charAt(0) == '-') {
            roomActivity.childActivities.splice(-1 * delta)
          }
        })
        roomActivity.start = roomActivity.childActivities.at(0).start
        roomActivity.end = roomActivity.childActivities.at(-1).end
      })
    })
  })
  console.log(await auth.patchWcif(req.competition, ['schedule'], req, res))
  res.redirect(req.path)
})

module.exports = {
  router: router
}
