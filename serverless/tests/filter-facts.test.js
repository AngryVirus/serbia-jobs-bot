import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, matches } from '../tgcloud/lib/filters.js';
import { job } from './fixtures.js';

const salaryJob = (salary, extra = {}) => {
  const raw = job(1, extra);
  return {...raw, _cloud:{...raw._cloud, salary}};
};

test('salary visibility separates stated pay from a guaranteed monthly minimum', () => {
  const s={...defaults(),include_unknown_salary:false};
  for(const salary of [
    {known:true,min:20,max:null,currency:'EUR',period:'hour'},
    {known:true,min:null,max:500,currency:'EUR',period:'month'},
  ]) assert(matches(salaryJob(salary,{salary_min:null}),s));
  const unknown={known:false,min:null,max:null,currency:null,period:null};
  assert(!matches(salaryJob(unknown),s));
  assert(matches(salaryJob(unknown),defaults()));
});

test('monthly salary minimum rejects stated low ceilings and incomparable units or currencies', () => {
  const s={...defaults(),min_salary:1000,currency:'EUR'};
  const cases=[
    [{known:true,min:null,max:500,currency:'EUR',period:'month'},false],
    [{known:true,min:null,max:2000,currency:'EUR',period:'month'},true],
    [{known:true,min:1000,max:2000,currency:'EUR',period:'month'},true],
    [{known:true,min:900,max:2000,currency:'EUR',period:'month'},false],
    [{known:true,min:20,max:null,currency:'EUR',period:'hour'},false],
    [{known:true,min:12000,max:null,currency:'EUR',period:'year'},false],
    [{known:true,min:120000,max:null,currency:'RSD',period:'month'},false],
    [{known:true,min:1000,max:null,currency:'EUR',period:null},false],
  ];
  for(const [facts,expected] of cases)assert.equal(matches(salaryJob(facts),s),expected,JSON.stringify(facts));
  assert(!matches(salaryJob(cases[1][0]),{...s,include_unknown_salary:false}));
});

test('legacy salary records preserve their contract until facts refresh', () => {
  assert(matches(job(1),{...defaults(),min_salary:1000,include_unknown_salary:false}));
  assert(!matches(job(1,{salary_min:900}),{...defaults(),min_salary:1000}));
  assert(!matches(job(1,{salary_min:120000,salary_currency:'RSD'}),{...defaults(),min_salary:1000}));
  assert(matches(job(1,{salary_min:null}),{...defaults(),min_salary:1000}));
});

test('derived language facts are authoritative for Russian, Serbian and English', () => {
  for(const [language,code] of [['russian','ru'],['serbian','sr'],['english','en']]) {
    const raw=job(1,{languages:[],russian:null,serbian_required:null});
    const actual={...raw,_cloud:{...raw._cloud,languages:[code]}};
    assert(matches(actual,{...defaults(),language}),language);
    assert(!matches({...actual,_cloud:{...actual._cloud,languages:[]}},{...defaults(),language}),language);
  }
  const raw=job(1,{languages:['sr']});delete raw._cloud.languages;
  assert(matches(raw,{...defaults(),language:'serbian'}));
});

test('derived remote evidence handles explicit unknown and legacy records', () => {
  const raw=job(1,{remote:false});
  assert(matches({...raw,_cloud:{...raw._cloud,remote:true}},{...defaults(),remote:'only'}));
  assert(!matches({...raw,_cloud:{...raw._cloud,remote:null}},{...defaults(),remote:'office'}));
  assert(matches(raw,{...defaults(),remote:'office'}));
});
