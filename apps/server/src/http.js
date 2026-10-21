export function sendJson(response,status,value){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(value));}
export async function readJson(request){
  let size=0;const chunks=[];
  for await(const chunk of request){size+=chunk.length;if(size>1_000_000){const error=new Error('Corpo excede 1 MB');error.status=413;throw error;}chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{const error=new Error('JSON inválido');error.status=400;throw error;}
}
