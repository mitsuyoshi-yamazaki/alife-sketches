/** 自動生成（node run.js）。手で書き換えない。 */
(function () {
  var OVERLAY = {
 "rows": [
  {
   "slug": "s01-raf-threshold",
   "id": "S-01",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameter",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "pRafThreshold",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "d1NullQuantile",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s02-primordial-particles",
   "id": "S-02",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameters",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "clusterRadius",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "clusterFractionThreshold",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "steps",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s03-lenia",
   "id": "S-03",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameters",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "muGrid",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "orderParameters.kernelExcess.threshold",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "orderParameters.kernelExcess.theoreticalNull",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "orderParameters.massRatio.primaryWindow",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s04-string-replicators",
   "id": "S-04",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameters",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "scales",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "thresholds",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "scales.measurementWindow",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s05-tierra-like",
   "id": "S-05",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameters",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "runScale",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "orderParameters.foreignCopyFraction.threshold",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "orderParameters.foreignCopyFraction.nullValue",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": false,
     "matched": "orderParameters.population",
     "corrected": true,
     "why": "この population は「終端時点で生存するプロセス数」という**秩序変数の名前**であって、誰を数えるかの宣言ではない。S-20 が同じ誤りを警告している"
    },
    "U": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "runScale",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s06-hypercycle-spatial",
   "id": "S-06",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameters",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "orderParameters.ringSurvival.scale",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "orderParameters.ringSurvival.threshold",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "orderParameters.cyclicRatio.theoreticalNull",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "config.warmupSteps",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s07-daisyworld",
   "id": "S-07",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameters",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "orderParameters.regulatedWidth.scale",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "orderParameters.regulatedWidth.threshold",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "orderParameters.regulatedWidth.theoreticalNull",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s08-turing-patterns",
   "id": "S-08",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameters",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "orderParameters.patternAmplitude.scale",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "orderParameters.patternAmplitude.threshold",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "orderParameters.patternAmplitude.theoreticalNull",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "config.totalTime",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s09-boids-information",
   "id": "S-09",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameters",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "scales",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "scales.arrivalThreshold",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "design.warmupSteps",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s11-neighbourhood-shape",
   "id": "S-11",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameters",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "system.interactionRadius",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "densityContrastThreshold",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "k19.nullProcess",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "system.steps",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s12-boundedness-illusion",
   "id": "S-12",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameters",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "scales",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "primary.recoverThreshold",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "scales.referencePoint",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "scales.time",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s13-ripley-k",
   "id": "S-13",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameterIsACurve",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "scale",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "thresholds",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "referencePoint",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "run",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s14-langton-ant",
   "id": "S-14",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameters",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "knobs.radius",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "knobs.driftFloor",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "orderParameters.referencePoint",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "orderParameters.onsetSteps",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s15-amphiphile-assembly",
   "id": "S-15",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameters",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "controlParameters.headRadius",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "thresholds",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "referencePoints",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "run",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s16-avida-like",
   "id": "S-16",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameters",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "runScale",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "orderParameters.taskTypesCredited.threshold",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "orderParameters.taskTypesCredited.nullValue",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": false,
     "matched": "orderParameters.population",
     "corrected": true,
     "why": "同上。「終端時点の生存プロセス数」という秩序変数の名前"
    },
    "U": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "runScale",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s17-coevolution",
   "id": "S-17",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameters",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "scale",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "thresholds",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "referencePoint",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": true,
     "matched": "decision.unitOfJudgement",
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "scale.generations",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s19-sugarscape",
   "id": "S-19",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameterIsACurve",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "primaryCurve.pGrid",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "thresholds",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "referencePoints",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": true,
     "matched": "knobs.population",
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "knobs.time",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s21-error-threshold",
   "id": "S-21",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameters",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "scale",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "thresholds",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "referencePoint",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": true,
     "matched": "knobSensitivity.knobs.population",
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "run",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s22-number-chemistry",
   "id": "S-22",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameters",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "scale",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "thresholds",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "referencePoints",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": false,
     "matched": null,
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": true,
     "matched": "decision.unitOfJudgement",
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "system.T",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s23-handmade-nca",
   "id": "S-23",
   "fields": {
    "V": {
     "registered": true,
     "matched": "source.primary",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "system.grid",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "thresholds",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "referencePoints",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": true,
     "matched": "population",
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": true,
     "matched": "decision.unitOfJudgement",
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "scale.T",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s24-asynchronous-life",
   "id": "S-24",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameters",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "fineGrid",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "thresholds",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "referencePoints",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": true,
     "matched": "population",
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": true,
     "matched": "unitOfJudgement",
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "scale.fitWindow",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s25-replicator-attribution",
   "id": "S-25",
   "fields": {
    "V": {
     "registered": true,
     "matched": "orderParameters",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "scale",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "revisionReason.finding1_theToleranceWasBelowItsOwnNoiseFloor",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "orderParameters.primary.nullValue",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": true,
     "matched": "population",
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": true,
     "matched": "unitOfJudgement",
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "scale.registeredWindow",
     "corrected": false,
     "why": null
    }
   }
  },
  {
   "slug": "s26-description-levels",
   "id": "S-26",
   "fields": {
    "V": {
     "registered": true,
     "matched": "levels.level0.descriptor",
     "corrected": false,
     "why": null
    },
    "S": {
     "registered": true,
     "matched": "levels",
     "corrected": false,
     "why": null
    },
    "Th": {
     "registered": true,
     "matched": "thresholds",
     "corrected": false,
     "why": null
    },
    "R": {
     "registered": true,
     "matched": "orderParameters.primary.referencePoint",
     "corrected": false,
     "why": null
    },
    "P": {
     "registered": true,
     "matched": "levels.level0.population",
     "corrected": false,
     "why": null
    },
    "U": {
     "registered": true,
     "matched": "decision.unitOfJudgement",
     "corrected": false,
     "why": null
    },
    "T": {
     "registered": true,
     "matched": "scale.T",
     "corrected": false,
     "why": null
    }
   }
  }
 ],
 "tally": {
  "V": {
   "n": 23,
   "of": 23,
   "sketches": [
    "s01-raf-threshold",
    "s02-primordial-particles",
    "s03-lenia",
    "s04-string-replicators",
    "s05-tierra-like",
    "s06-hypercycle-spatial",
    "s07-daisyworld",
    "s08-turing-patterns",
    "s09-boids-information",
    "s11-neighbourhood-shape",
    "s12-boundedness-illusion",
    "s13-ripley-k",
    "s14-langton-ant",
    "s15-amphiphile-assembly",
    "s16-avida-like",
    "s17-coevolution",
    "s19-sugarscape",
    "s21-error-threshold",
    "s22-number-chemistry",
    "s23-handmade-nca",
    "s24-asynchronous-life",
    "s25-replicator-attribution",
    "s26-description-levels"
   ]
  },
  "S": {
   "n": 22,
   "of": 23,
   "sketches": [
    "s02-primordial-particles",
    "s03-lenia",
    "s04-string-replicators",
    "s05-tierra-like",
    "s06-hypercycle-spatial",
    "s07-daisyworld",
    "s08-turing-patterns",
    "s09-boids-information",
    "s11-neighbourhood-shape",
    "s12-boundedness-illusion",
    "s13-ripley-k",
    "s14-langton-ant",
    "s15-amphiphile-assembly",
    "s16-avida-like",
    "s17-coevolution",
    "s19-sugarscape",
    "s21-error-threshold",
    "s22-number-chemistry",
    "s23-handmade-nca",
    "s24-asynchronous-life",
    "s25-replicator-attribution",
    "s26-description-levels"
   ]
  },
  "Th": {
   "n": 23,
   "of": 23,
   "sketches": [
    "s01-raf-threshold",
    "s02-primordial-particles",
    "s03-lenia",
    "s04-string-replicators",
    "s05-tierra-like",
    "s06-hypercycle-spatial",
    "s07-daisyworld",
    "s08-turing-patterns",
    "s09-boids-information",
    "s11-neighbourhood-shape",
    "s12-boundedness-illusion",
    "s13-ripley-k",
    "s14-langton-ant",
    "s15-amphiphile-assembly",
    "s16-avida-like",
    "s17-coevolution",
    "s19-sugarscape",
    "s21-error-threshold",
    "s22-number-chemistry",
    "s23-handmade-nca",
    "s24-asynchronous-life",
    "s25-replicator-attribution",
    "s26-description-levels"
   ]
  },
  "R": {
   "n": 20,
   "of": 23,
   "sketches": [
    "s01-raf-threshold",
    "s03-lenia",
    "s05-tierra-like",
    "s06-hypercycle-spatial",
    "s07-daisyworld",
    "s08-turing-patterns",
    "s11-neighbourhood-shape",
    "s12-boundedness-illusion",
    "s13-ripley-k",
    "s14-langton-ant",
    "s15-amphiphile-assembly",
    "s16-avida-like",
    "s17-coevolution",
    "s19-sugarscape",
    "s21-error-threshold",
    "s22-number-chemistry",
    "s23-handmade-nca",
    "s24-asynchronous-life",
    "s25-replicator-attribution",
    "s26-description-levels"
   ]
  },
  "P": {
   "n": 6,
   "of": 23,
   "sketches": [
    "s19-sugarscape",
    "s21-error-threshold",
    "s23-handmade-nca",
    "s24-asynchronous-life",
    "s25-replicator-attribution",
    "s26-description-levels"
   ]
  },
  "U": {
   "n": 6,
   "of": 23,
   "sketches": [
    "s17-coevolution",
    "s22-number-chemistry",
    "s23-handmade-nca",
    "s24-asynchronous-life",
    "s25-replicator-attribution",
    "s26-description-levels"
   ]
  },
  "T": {
   "n": 21,
   "of": 23,
   "sketches": [
    "s02-primordial-particles",
    "s03-lenia",
    "s04-string-replicators",
    "s05-tierra-like",
    "s06-hypercycle-spatial",
    "s08-turing-patterns",
    "s09-boids-information",
    "s11-neighbourhood-shape",
    "s12-boundedness-illusion",
    "s13-ripley-k",
    "s14-langton-ant",
    "s15-amphiphile-assembly",
    "s16-avida-like",
    "s17-coevolution",
    "s19-sugarscape",
    "s21-error-threshold",
    "s22-number-chemistry",
    "s23-handmade-nca",
    "s24-asynchronous-life",
    "s25-replicator-attribution",
    "s26-description-levels"
   ]
  }
 },
 "generatedFrom": [
  "s01-raf-threshold",
  "s02-primordial-particles",
  "s03-lenia",
  "s04-string-replicators",
  "s05-tierra-like",
  "s06-hypercycle-spatial",
  "s07-daisyworld",
  "s08-turing-patterns",
  "s09-boids-information",
  "s11-neighbourhood-shape",
  "s12-boundedness-illusion",
  "s13-ripley-k",
  "s14-langton-ant",
  "s15-amphiphile-assembly",
  "s16-avida-like",
  "s17-coevolution",
  "s19-sugarscape",
  "s21-error-threshold",
  "s22-number-chemistry",
  "s23-handmade-nca",
  "s24-asynchronous-life",
  "s25-replicator-attribution",
  "s26-description-levels"
 ]
};
  var PREDICTION = {
 "note": "K-52。本文を読む前に 14 entry × 5 列 = 70 マスを全部埋める。的中率そのものより、外れたマスが1つの機構に帰着するかを見る。",
 "M01": {
  "label": "Bedau & Packard 1992 進化的活性と中立影",
  "V": "filled",
  "S": "open",
  "Th": "open",
  "R": "filled",
  "P": "open"
 },
 "M02": {
  "label": "Bedau, Snyder & Packard 1998 活性統計とクラス分け",
  "V": "filled",
  "S": "open",
  "Th": "filled",
  "R": "filled",
  "P": "open"
 },
 "M03": {
  "label": "Bedau ほか 2003 進化的活性の一般枠組",
  "V": "filled",
  "S": "filled",
  "Th": "open",
  "R": "filled",
  "P": "open"
 },
 "M04": {
  "label": "Standish 2000 Ecolab から見た Bedau 統計",
  "V": "filled",
  "S": "open",
  "Th": "filled",
  "R": "filled",
  "P": "open"
 },
 "M05": {
  "label": "Standish 2003 開放的な人工進化",
  "V": "filled",
  "S": "open",
  "Th": "open",
  "R": "open",
  "P": "open"
 },
 "M06": {
  "label": "Channon 2001 Geb と中央値の活性",
  "V": "filled",
  "S": "open",
  "Th": "filled",
  "R": "filled",
  "P": "open"
 },
 "M07": {
  "label": "Taylor et al. 2016 OEE ワークショップ報告",
  "V": "open",
  "S": "absent",
  "Th": "absent",
  "R": "absent",
  "P": "absent"
 },
 "M08": {
  "label": "Lehman & Stanley 2011 新奇性探索",
  "V": "filled",
  "S": "filled",
  "Th": "filled",
  "R": "open",
  "P": "filled"
 },
 "M09": {
  "label": "Soros & Stanley 2014 minimal criteria（Chromaria）",
  "V": "open",
  "S": "absent",
  "Th": "filled",
  "R": "absent",
  "P": "absent"
 },
 "M10": {
  "label": "Dolson et al. 2019 MODES",
  "V": "filled",
  "S": "filled",
  "Th": "filled",
  "R": "open",
  "P": "filled"
 },
 "M11": {
  "label": "Packard et al. 2019 OEE 概観（編集序文）",
  "V": "open",
  "S": "absent",
  "Th": "absent",
  "R": "absent",
  "P": "absent"
 },
 "M12": {
  "label": "Hintze 2019 批判",
  "V": "open",
  "S": "absent",
  "Th": "open",
  "R": "absent",
  "P": "absent"
 },
 "M13": {
  "label": "Pattee & Sayama 2019 進化した開放性",
  "V": "absent",
  "S": "absent",
  "Th": "absent",
  "R": "absent",
  "P": "absent"
 },
 "M14": {
  "label": "Bullock & Bedau 2006 活性統計で適応の動態を探る",
  "V": "filled",
  "S": "filled",
  "Th": "open",
  "R": "filled",
  "P": "open"
 }
};
  if (typeof module === "object" && module.exports) module.exports = { OVERLAY: OVERLAY, PREDICTION: PREDICTION };
  if (typeof window !== "undefined") { window.S27_OVERLAY = OVERLAY; window.S27_PREDICTION = PREDICTION; }
}());
