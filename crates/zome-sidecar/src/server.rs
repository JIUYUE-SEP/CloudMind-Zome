use tonic::{Request, Response, Status};
use tracing::info;

use crate::supervisor;
use crate::tokenizer;
use crate::vector;
use crate::zome::zome_sidecar_server::{ZomeSidecar, ZomeSidecarServer};
use crate::zome::{
    DeleteAgentRequest, DeleteAgentResponse, HealthRequest, HealthResponse, SearchRequest,
    SearchResponse, SearchResult, TokenCountRequest, TokenCountResponse, UpsertRequest,
    UpsertResponse,
};

#[derive(Default)]
pub struct ZomeSidecarService;

#[tonic::async_trait]
impl ZomeSidecar for ZomeSidecarService {
    async fn upsert(
        &self,
        request: Request<UpsertRequest>,
    ) -> Result<Response<UpsertResponse>, Status> {
        let req = request.into_inner();
        let agent_id = crate::sanitize_agent_id(&req.agent_id)
            .map_err(|e| Status::invalid_argument(e.to_string()))?;
        let state = vector::get_or_load(&agent_id)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        state
            .write()
            .await
            .upsert(&req.doc_id, &req.embedding)
            .await;
        Ok(Response::new(UpsertResponse {}))
    }

    async fn search(
        &self,
        request: Request<SearchRequest>,
    ) -> Result<Response<SearchResponse>, Status> {
        let req = request.into_inner();
        let agent_id = crate::sanitize_agent_id(&req.agent_id)
            .map_err(|e| Status::invalid_argument(e.to_string()))?;
        let state = vector::get_or_load(&agent_id)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        let results = state
            .read()
            .await
            .search(&req.query, req.top_k as usize)
            .into_iter()
            .map(|(doc_id, score)| SearchResult { doc_id, score })
            .collect();
        Ok(Response::new(SearchResponse { results }))
    }

    async fn count_tokens(
        &self,
        request: Request<TokenCountRequest>,
    ) -> Result<Response<TokenCountResponse>, Status> {
        let req = request.into_inner();
        let count = tokenizer::count_tokens(&req.text, &req.model);
        Ok(Response::new(TokenCountResponse { count }))
    }

    async fn delete_agent(
        &self,
        request: Request<DeleteAgentRequest>,
    ) -> Result<Response<DeleteAgentResponse>, Status> {
        let req = request.into_inner();
        let agent_id = crate::sanitize_agent_id(&req.agent_id)
            .map_err(|e| Status::invalid_argument(e.to_string()))?;
        vector::delete_agent(&agent_id)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(Response::new(DeleteAgentResponse {}))
    }

    async fn health(
        &self,
        _request: Request<HealthRequest>,
    ) -> Result<Response<HealthResponse>, Status> {
        let status = if supervisor::is_node_healthy().await {
            "ok"
        } else {
            "degraded"
        }
        .to_string();
        Ok(Response::new(HealthResponse { status }))
    }
}

pub async fn serve() -> anyhow::Result<()> {
    let addr = "127.0.0.1:50051".parse()?;
    info!("gRPC listening on {}", addr);

    tonic::transport::Server::builder()
        .add_service(ZomeSidecarServer::new(ZomeSidecarService))
        .serve(addr)
        .await?;

    Ok(())
}
